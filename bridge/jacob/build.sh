#!/usr/bin/env bash
# Builds sap-bridge.jar from SapBridge.java + Json.java against your existing JACOB jar.
#   ./build.sh /path/to/jacob-1.18.jar            ->  ./sap-bridge.jar
set -euo pipefail
JACOB_JAR="${1:?usage: build.sh <path to jacob.jar>}"
cd "$(dirname "$0")"
rm -rf out && mkdir out
javac --release 8 -encoding UTF-8 -cp "$JACOB_JAR" -d out src/*.java
jar cf sap-bridge.jar -C out .
echo "built $(pwd)/sap-bridge.jar"
