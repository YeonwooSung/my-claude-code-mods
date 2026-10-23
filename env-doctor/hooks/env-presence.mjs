// Inspect a variable's name only. Never retrieve, print or retain its value.
const variableName = process.argv[2]
if (!variableName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variableName)) {
  process.exitCode = 2
} else {
  process.stdout.write(Object.hasOwn(process.env, variableName) ? 'set' : '')
}
