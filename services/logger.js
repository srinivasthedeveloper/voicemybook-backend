const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function enabled(level) {
  return LEVELS[level] <= threshold;
}

function write(level, scope, msg, extra) {
  if (!enabled(level)) return;
  const text = typeof msg === 'function' ? msg() : msg;
  let line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${text}`;
  if (extra) {
    const { err, ...rest } = extra;
    if (Object.keys(rest).length) line += ` ${JSON.stringify(rest)}`;
    if (err) line += `\n${err instanceof Error ? err.stack : String(err)}`;
  }
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

module.exports = {
  enabled,
  error: (scope, msg, extra) => write('error', scope, msg, extra),
  warn:  (scope, msg, extra) => write('warn', scope, msg, extra),
  info:  (scope, msg, extra) => write('info', scope, msg, extra),
  debug: (scope, msg, extra) => write('debug', scope, msg, extra),
};
