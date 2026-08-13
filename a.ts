const filenames = [
  "ask.txt",
  "bid.txt",
  "index.txt",
  "indexLast.txt",
  "last.txt",
  "mark.txt",
  "markLast.txt",
];

console.log(filenames)

const symbol = "BTCUSDT"
const prefixed = filenames.map((filename) => `${symbol}-${filename}`);

console.log(prefixed);
