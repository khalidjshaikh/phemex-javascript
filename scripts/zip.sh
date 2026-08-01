cd "$(dirname "$0")/.."
zip -r ~/phemex-$(date +%F).zip . \
  -x "node_modules/*" \
  -x ".git/*" \
  -x "ticker/php-ticker/vendor/*" \
  -x "ticker/rust-ticker/target/*" \
  -x "ticker/csharp-ticker/obj/*" \
  -x "ticker/kt-ticker/build/*" \
  -x "ticker/kt-ticker/.gradle/*" \
  -x "ticker/kt-ticker/gradle/*" \
  -x "ticker/ts-ticker/node_modules/*" \
  -x "ticker/cpp-ticker/build/*" \
  -x "ticker/cpp-ticker/deps/*" \
  -x "ticker/java-ticker/build/*" \
  -x "ticker/java-ticker/.gradle/*" \
  -x "ticker/java-ticker/gradle/*" \
  -x "ticker/java-ticker/bin/*" \
  -x ".github/*" \
  -x "ticker/csharp-ticker/bin/*"
