export type BashCategory = 'test' | 'build' | 'install' | 'git' | 'search' | 'other'

const RULES: [BashCategory, RegExp][] = [
  ['test', /\b(jest|vitest|mocha|pytest|tox|nox|rspec|phpunit|ctest|cypress\s+run|playwright\s+test)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(go|cargo|deno|bun|dotnet|mix|swift)\s+test\b|\bnode\s+--test\b|\b(gradlew?|mvn)\b.*\btest\b|\bmake\s+(test|check)\b|\bclaude\s+plugin\s+test\b/],
  ['install', /\b(npm|pnpm|yarn|bun)\s+(install|i|add|ci)\b|\bpip3?\s+install\b|\buv\s+(pip|sync|add)\b|\bpoetry\s+(install|add)\b|\bbrew\s+install\b|\bapt(-get)?\s+install\b|\bcargo\s+(add|install|fetch)\b|\bgo\s+(get|mod\s+download)\b|\bbundle\s+install\b/],
  ['build', /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|^\s*(tsc|webpack|esbuild|rollup|make|cmake|ninja|bazel)\b|\bvite\s+build\b|\b(cargo|go|swift|dotnet)\s+build\b|\b(gradlew?|mvn)\b|\bdocker\s+build\b/],
  ['git', /^\s*(git|gh)\b/],
  ['search', /^\s*(rg|grep|ag|ack|find|fd|ls|tree|cat|head|tail|wc)\b/],
]

const RANK: BashCategory[] = ['test', 'build', 'install', 'git', 'search', 'other']

function classifySegment(segment: string): BashCategory {
  return RULES.find(([, pattern]) => pattern.test(segment))?.[0] ?? 'other'
}

export function classifyCommand(command: string): BashCategory {
  const segments = command.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean)
  let best: BashCategory = 'other'
  for (const segment of segments) {
    const category = classifySegment(segment)
    if (RANK.indexOf(category) < RANK.indexOf(best)) best = category
  }
  return best
}
