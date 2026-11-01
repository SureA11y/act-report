'use strict';

// @surea11y/selenium, through WebDriver BiDi (../bidi.js). selenium-webdriver
// sends a raw BiDi command on the session's connection and re-emits each BiDi
// event by its method name. The connection comes from getBidiConnection, the
// module WebDriver#getBidi() (deprecated) delegates to.

const { fromCore, checkEngineVersion, requireEnv, CORE_DIR } = require('../lib.js');
const { openBidiRunner } = require('../bidi.js');

function bidiConnectionOf(driver) {
  try {
    const { getBidiConnection } = require(
      require.resolve('selenium-webdriver/lib/bidi_connection', { paths: [CORE_DIR] })
    );
    return getBidiConnection(driver);
  } catch {
    return driver.getBidi();
  }
}

async function openSeleniumRunner(options, helpers) {
  requireEnv('selenium', 'CHROME_BINARY', 'CHROMEDRIVER_BINARY');
  const bindingVersion = checkEngineVersion('@surea11y/selenium');
  const { Builder, Browser } = fromCore('selenium-webdriver');
  const chrome = fromCore('selenium-webdriver/chrome');
  const { A11yCoreBuilder } = fromCore('@surea11y/selenium');

  const adapter = {
    async openSession({ pageLoadStrategy, chromeArgs, loadTimeoutMs }) {
      const chromeOptions = new chrome.Options()
        .setChromeBinaryPath(process.env.CHROME_BINARY)
        .addArguments(...chromeArgs)
        .setPageLoadStrategy(pageLoadStrategy)
        .enableBidi();
      const driver = await new Builder()
        .forBrowser(Browser.CHROME)
        .setChromeOptions(chromeOptions)
        .setChromeService(new chrome.ServiceBuilder(process.env.CHROMEDRIVER_BINARY))
        .build();
      await driver.manage().setTimeouts({ script: loadTimeoutMs });
      const bidi = await bidiConnectionOf(driver);
      const capabilities = await driver.getCapabilities();
      return {
        async send(method, params) {
          const response = await bidi.send({ method, params });
          if (response.type === 'error') {
            throw new Error(`${method}: ${response.error}: ${response.message}`);
          }
          return response.result;
        },
        on: (event, listener) => bidi.on(event, listener),
        windowHandle: () => driver.getWindowHandle(),
        switchToWindow: (handle) => driver.switchTo().window(handle),
        navigate: (url) => driver.get(url),
        execute: (fn) => driver.executeScript(fn),
        builder: () => new A11yCoreBuilder({ driver }),
        browserVersion: capabilities.get('browserVersion'),
        close: () => driver.quit()
      };
    }
  };

  const runner = await openBidiRunner(adapter, options, helpers);
  return {
    scan: runner.scan,
    version: `Chrome/${runner.browserVersion}, @surea11y/selenium ${bindingVersion}`,
    close: runner.close
  };
}

module.exports = { openRunner: openSeleniumRunner };
