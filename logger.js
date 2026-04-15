// Simple logger with ISO timestamps and log levels.
// No external dependencies — wraps console.log/error.

const LEVELS = {DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3};
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LEVELS.INFO;

function log(level, module, message, extra) {
    if (LEVELS[level] < MIN_LEVEL) return;

    const ts    = new Date().toISOString();
    const label = level.padEnd(5);
    const out   = `${ts} [${label}] [${module}] ${message}`;

    const printer = level === 'ERROR' || level === 'WARN' ? console.error : console.log;

    if (extra !== undefined && extra !== null) {
        if (extra instanceof Error) {
            printer(out, extra.stack || extra.message);
        } else if (typeof extra === 'object') {
            printer(out, JSON.stringify(extra));
        } else {
            printer(out, extra);
        }
    } else {
        printer(out);
    }
}

function createLogger(module) {
    return {
        debug: (msg, extra) => log('DEBUG', module, msg, extra),
        info:  (msg, extra) => log('INFO',  module, msg, extra),
        warn:  (msg, extra) => log('WARN',  module, msg, extra),
        error: (msg, extra) => log('ERROR', module, msg, extra),
    };
}

module.exports = {createLogger};
