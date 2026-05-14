const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

/**
 * Structured console + optional file logging.
 */
class Logger {
  constructor(options = {}) {
    this.fileStream = null;
    if (options.logToFile) {
      const dir = path.join(__dirname, '..', '..', 'logs');
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      this.fileStream = fs.createWriteStream(path.join(dir, `migration-${stamp}.log`), { flags: 'a' });
    }
  }

  /**
   * @param {string} line
   */
  _writeFile(line) {
    if (this.fileStream) {
      this.fileStream.write(`${line}\n`);
    }
  }

  /**
   * @param {string} msg
   */
  info(msg) {
    const line = `[INFO] ${msg}`;
    console.log(chalk.cyan(line));
    this._writeFile(line);
  }

  /**
   * @param {string} msg
   */
  success(msg) {
    const line = `[OK] ${msg}`;
    console.log(chalk.green(line));
    this._writeFile(line);
  }

  /**
   * @param {string} msg
   */
  warn(msg) {
    const line = `[WARN] ${msg}`;
    console.log(chalk.yellow(line));
    this._writeFile(line);
  }

  /**
   * @param {string} msg
   * @param {unknown} [err]
   */
  error(msg, err) {
    const line = `[ERROR] ${msg}${err ? ` — ${String(err)}` : ''}`;
    console.error(chalk.red(line));
    if (err && err.stack) {
      console.error(chalk.gray(err.stack));
      this._writeFile(`${line}\n${err.stack}`);
    } else {
      this._writeFile(line);
    }
  }

  /**
   * @param {Record<string, unknown>} fields
   */
  batch(fields) {
    const parts = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
    const line = `[BATCH] ${parts.join(' | ')}`;
    console.log(chalk.blue(line));
    this._writeFile(line);
  }

  close() {
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = null;
    }
  }
}

module.exports = { Logger };
