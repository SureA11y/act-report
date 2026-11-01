'use strict';

// @surea11y/webdriverio, through WebDriver BiDi (../bidi.js). webdriverio
// names each BiDi command as a method: network.addIntercept is
// browser.networkAddIntercept.

const { fromCore, checkEngineVersion, requireEnv } = require('../lib.js');
const { openBidiRunner } = require('../bidi.js');

async function openWebdriverioRunner(options, helpers) {
  requireEnv('webdriverio', 'CHROME_BINARY', 'CHROMEDRIVER_BINARY');
  const bindingVersion = checkEngineVersion('@surea11y/webdriverio');
  const { remote } = fromCore('webdriverio');
  const { A11yCoreBuilder } = fromCore('@surea11y/webdriverio');
  const methodOf = (command) => command.replace(/\.(\w)/, (_, c) => c.toUpperCase());

  const adapter = {
    async openSession({ pageLoadStrategy, chromeArgs, loadTimeoutMs }) {
      const browser = await remote({
        logLevel: 'error',
        connectionRetryTimeout: loadTimeoutMs * 2,
        capabilities: {
          browserName: 'chrome',
          webSocketUrl: true,
          pageLoadStrategy,
          'goog:chromeOptions': { binary: process.env.CHROME_BINARY, args: chromeArgs },
          'wdio:chromedriverOptions': { binary: process.env.CHROMEDRIVER_BINARY }
        }
      });
      await browser.setTimeout({ script: loadTimeoutMs });
      return {
        send: (command, params) => browser[methodOf(command)](params),
        on: (event, listener) => browser.on(event, listener),
        windowHandle: () => browser.getWindowHandle(),
        switchToWindow: (handle) => browser.switchToWindow(handle),
        navigate: (url) => browser.url(url),
        execute: (fn) => browser.execute(fn),
        builder: () => new A11yCoreBuilder({ browser }),
        browserVersion: browser.capabilities.browserVersion,
        close: () => browser.deleteSession()
      };
    }
  };

  const runner = await openBidiRunner(adapter, options, helpers);
  return {
    scan: runner.scan,
    version: `Chrome/${runner.browserVersion}, @surea11y/webdriverio ${bindingVersion}`,
    close: runner.close
  };
}

module.exports = { openRunner: openWebdriverioRunner };
