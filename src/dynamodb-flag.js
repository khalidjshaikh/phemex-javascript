import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  CreateTableCommand,
  DescribeTableCommand,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const DEFAULT_TABLE = process.env.FLAG_TABLE ?? "flags";

/**
 * Create a DynamoDB client.
 * Credentials are resolved from the default AWS credential chain
 * (env vars, ~/.aws/credentials, IAM role, etc.).
 */
function createClient(opts = {}) {
  return new DynamoDBClient({ region: opts.region ?? process.env.AWS_REGION ?? "us-east-1", ...opts });
}

/**
 * Ensure the DynamoDB table exists; create it on-demand if missing.
 *
 * @param {string} table
 * @param {DynamoDBClient} client
 */
async function ensureTable(table, client) {
  try {
    await client.send(new CreateTableCommand({
      TableName: table,
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
      BillingMode: "PAY_PER_REQUEST",
    }));
    // Wait for the table to become ACTIVE before proceeding.
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: table });
  } catch (err) {
    // Swallow "Table already exists" — another caller may have raced.
    if (err.name !== "ResourceInUseException") throw err;
  }
}

/**
 * Read a flag from DynamoDB.
 *
 * @param {string} key - The flag's primary key value.
 * @param {object}  [options]
 * @param {string}  [options.table]  - DynamoDB table name (default: FLAG_TABLE env or "flags").
 * @param {boolean} [options.strict] - When true, throw if the flag does not exist.
 * @param {boolean} [options.autoCreate] - Auto-create the table if missing (default: true).
 * @param {object}  [options.client] - Reusable DynamoDBClient (default: creates a fresh one).
 * @returns {Promise<boolean|null>} The flag value, or null when not found (unless strict).
 */
export async function getFlag(key, options = {}) {
  const table = options.table ?? DEFAULT_TABLE;
  const autoCreate = options.autoCreate !== false;
  const client = options.client ?? createClient();

  try {
    const cmd = new GetItemCommand({
      TableName: table,
      Key: marshall({ pk: key }),
      ConsistentRead: true,
    });

    const resp = await client.send(cmd);

    if (!resp.Item) {
      if (options.strict) {
        throw new Error(`Flag "${key}" not found in table "${table}"`);
      }
      return null;
    }

    const item = unmarshall(resp.Item);
    return item.value ?? null;
  } catch (err) {
    if (autoCreate && err.name === "ResourceNotFoundException") {
      await ensureTable(table, client);
      // Retry once without autoCreate to avoid infinite loops.
      return getFlag(key, { ...options, autoCreate: false });
    }
    throw err;
  }
}

/**
 * Set (upsert) a flag in DynamoDB.
 *
 * @param {string}  key   - The flag's primary key value.
 * @param {boolean} value - The boolean value to store.
 * @param {object}  [options]
 * @param {string}  [options.table]     - DynamoDB table name (default: FLAG_TABLE env or "flags").
 * @param {boolean} [options.autoCreate] - Auto-create the table if missing (default: true).
 * @param {object}  [options.client]    - Reusable DynamoDBClient.
 * @returns {Promise<void>}
 */
export async function setFlag(key, value, options = {}) {
  const table = options.table ?? DEFAULT_TABLE;
  const autoCreate = options.autoCreate !== false;
  const client = options.client ?? createClient();

  try {
    const cmd = new PutItemCommand({
      TableName: table,
      Item: marshall({
        pk: key,
        value: Boolean(value),
      }),
    });

    await client.send(cmd);
  } catch (err) {
    if (autoCreate && err.name === "ResourceNotFoundException") {
      await ensureTable(table, client);
      // Retry once without autoCreate to avoid infinite loops.
      return setFlag(key, value, { ...options, autoCreate: false });
    }
    throw err;
  }
}