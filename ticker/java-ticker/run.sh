#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Dependency: org.json
JSON_VERSION="20250107"
JSON_JAR="json-${JSON_VERSION}.jar"
JSON_URL="https://repo1.maven.org/maven2/org/json/json/${JSON_VERSION}/${JSON_JAR}"

# Look for the jar in Gradle cache first, then local lib/, else download it
if [ -f "${HOME}/.gradle/caches/modules-2/files-2.1/org.json/json/${JSON_VERSION}/"*/"${JSON_JAR}" ]; then
  # glob match — pick the first one
  DEP_JAR=$(ls "${HOME}"/.gradle/caches/modules-2/files-2.1/org.json/json/${JSON_VERSION}/*/"${JSON_JAR}" 2>/dev/null | head -1)
elif [ -f "lib/${JSON_JAR}" ]; then
  DEP_JAR="lib/${JSON_JAR}"
else
  echo "Downloading ${JSON_JAR} ..."
  mkdir -p lib
  curl -sL -o "lib/${JSON_JAR}" "${JSON_URL}"
  DEP_JAR="lib/${JSON_JAR}"
fi

SRC="src/main/java/com/phemex/TickerClient.java"
OUT="build/classes"

echo "Compiling ..."
mkdir -p "${OUT}"
javac -d "${OUT}" -cp "${DEP_JAR}" "${SRC}"

echo "Running ..."
java -cp "${OUT}:${DEP_JAR}" com.phemex.TickerClient