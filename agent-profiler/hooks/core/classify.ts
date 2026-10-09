export type BashCategory = 'test' | 'build' | 'install' | 'git' | 'search' | 'other'

// Blank out single/double quoted strings and $(...) bodies before splitting
function blankOutStringLiterals(command: string): string {
  let result = ''
  let i = 0

  while (i < command.length) {
    // Single-quoted string: no escaping inside
    if (command[i] === "'") {
      result += "'"
      i++
      while (i < command.length && command[i] !== "'") {
        result += ' '
        i++
      }
      if (i < command.length) {
        result += "'"
        i++
      }
    }
    // Double-quoted string: escaping possible
    else if (command[i] === '"') {
      result += '"'
      i++
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < command.length) {
          result += '  '
          i += 2
        } else {
          result += ' '
          i++
        }
      }
      if (i < command.length) {
        result += '"'
        i++
      }
    }
    // $(...) substitution
    else if (command[i] === '$' && i + 1 < command.length && command[i + 1] === '(') {
      result += '  '
      i += 2
      let depth = 1
      while (i < command.length && depth > 0) {
        if (command[i] === '(') {
          depth++
        } else if (command[i] === ')') {
          depth--
        }
        result += depth === 0 ? ')' : ' '
        i++
      }
    } else {
      result += command[i]
      i++
    }
  }

  return result
}

// Normalise: strip leading env vars and wrappers
function normalise(segment: string): string {
  if (typeof segment !== 'string') return ''

  let s = segment.trim()
  const wrappers = ['pnpm exec', 'poetry run', 'yarn dlx', 'uv run', 'npx', 'bunx', 'env', 'time', 'sudo']

  let changed = true
  while (changed) {
    changed = false

    // Strip leading env var assignments (VAR=value ...)
    const envMatch = s.match(/^([A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/)
    if (envMatch) {
      s = s.slice(envMatch[0].length).trim()
      changed = true
      continue
    }

    // Strip leading wrappers
    for (const wrapper of wrappers) {
      if (s.startsWith(wrapper + ' ')) {
        s = s.slice(wrapper.length + 1).trim()
        changed = true
        break
      }
    }
  }

  return s
}

// Classify gradle/gradlew/mvn commands by analyzing task tokens
function classifyGradleMvn(segment: string): BashCategory {
  const tokens = segment.split(/\s+/)

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]

    // Skip if it starts with - (flag or option)
    if (token.startsWith('-')) {
      // Special case: if this is -x and next token is test, skip both
      if (token === '-x' && i + 1 < tokens.length && tokens[i + 1] === 'test') {
        i++ // skip the test token too
      }
      continue
    }

    // Check if this is a test task
    if (token === 'test' || token === 'verify' || token === 'check' || token.endsWith(':test')) {
      return 'test'
    }
  }

  return 'build'
}

const RULES: [BashCategory, RegExp][] = [
  ['test', /^(jest|vitest|mocha|pytest|tox|nox|rspec|phpunit|ctest|nosetests|bats|karma|ava|jasmine)\b/],
  ['test', /^cypress\s+run\b/],
  ['test', /^playwright\s+test\b/],
  ['test', /^(npm|bun)\s+(run\s+)?test\b/],
  ['test', /^npm\s+t\b/],
  ['test', /^(pnpm|yarn)\s+((-r|--filter\s+\S+)\s+)?(run\s+)?test\b/],
  ['test', /^(go|cargo|deno|dotnet|mix|swift)\s+test\b/],
  ['test', /^cargo\s+nextest\s+run\b/],
  ['test', /^node\s+--test\b/],
  ['test', /^(python|python3)\s+-m\s+(unittest|pytest)\b/],
  ['test', /^make\s+(test|check)\b/],
  ['test', /^claude\s+plugin\s+test\b/],
  ['install', /^(npm|pnpm|yarn|bun)\s+(install|i|add|ci)\b/],
  ['install', /^yarn\s*$/],
  ['install', /^(pip|pip3)\s+install\b/],
  ['install', /^uv\s+(pip|sync|add)\b/],
  ['install', /^poetry\s+install\b/],
  ['install', /^brew\s+install\b/],
  ['install', /^(apt|apt-get)\s+install\b/],
  ['install', /^cargo\s+(add|install|fetch)\b/],
  ['install', /^go\s+(get|mod\s+download)\b/],
  ['install', /^bundle\s+install\b/],
  ['build', /^(tsc|webpack|esbuild|rollup|make|cmake|ninja|bazel)\b/],
  ['build', /^(npm|pnpm|yarn|bun)\s+(run\s+)?build\b/],
  ['build', /^vite\s+build\b/],
  ['build', /^(cargo|go|swift|dotnet)\s+build\b/],
  ['build', /^docker\s+build\b/],
  ['git', /^(git|gh)\b/],
  ['search', /^(rg|grep|ag|ack|find|fd|ls|tree|cat|head|tail|wc)\b/],
]

const RANK: BashCategory[] = ['test', 'build', 'install', 'git', 'search', 'other']

function classifySegment(segment: string): BashCategory {
  const normalized = normalise(segment)

  // Special handling for gradle/mvn commands
  const cmd = normalized.replace(/^\.\//, '').split(/\s+/)[0]
  if (cmd === 'gradle' || cmd === 'gradlew' || cmd === 'mvn') {
    return classifyGradleMvn(normalized)
  }

  return RULES.find(([, pattern]) => pattern.test(normalized))?.[0] ?? 'other'
}

export function classifyCommand(command: string): BashCategory {
  if (typeof command !== 'string') return 'other'

  const blanked = blankOutStringLiterals(command)
  const segments = blanked
    .split(/&&|\|\||;|\||\n|[&](?![&])/)
    .map(s => s.trim())
    .filter(Boolean)

  let best: BashCategory = 'other'
  for (const segment of segments) {
    const category = classifySegment(segment)
    if (RANK.indexOf(category) < RANK.indexOf(best)) best = category
  }
  return best
}
