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

// Commands go out on the session's BiDi connection, but not through its
// send(): that gives every command 30 s, fixed, and a large response body
// (f51b46's 35 MB video) takes longer to hand to ChromeDriver. They carry ids
// of their own, far above the connection's, whose dispatcher passes over a
// response it did not ask for; events still come through the connection.
function commandSender(bidi, timeoutMs) {
  const pending = new Map();
  let nextId = 1e9;
  let socket = null;
  async function open() {
    if (socket) return socket;
    await bidi.waitForConnection();
    socket = bidi.socket;
    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.settle(message);
    });
    return socket;
  }
  return async function send(method, params) {
    const ws = await open();
    const id = nextId++;
    const message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} had no answer in ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { timer, settle: resolve });
      ws.send(JSON.stringify({ id, method, params }));
    });
    if (message.type === 'error') {
      throw new Error(`${method}: ${message.error}: ${message.message}`);
    }
    return message.result;
  };
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
      const send = commandSender(bidi, loadTimeoutMs * 2);
      let context = await driver.getWindowHandle();
      return {
        send,
        on: (event, listener) => bidi.on(event, listener),
        windowHandle: () => driver.getWindowHandle(),
        async switchToWindow(handle) {
          await driver.switchTo().window(handle);
          context = handle;
        },
        // The runner's own checks run over BiDi, not executeScript: ChromeDriver
        // serves a classic command and a BiDi one in turn, and a classic
        // script waiting on a navigation the runner is answering (the 204 for
        // a test case that refreshes itself away) holds that answer back
        // until the script times out. The binding's scan still runs its own
        // way, through executeScript, as a user's test does.
        async execute(fn) {
          const result = await send('script.callFunction', {
            functionDeclaration: fn.toString(),
            awaitPromise: true,
            target: { context }
          });
          if (result.type === 'exception') {
            throw new Error(result.exceptionDetails.text || 'script error');
          }
          return result.result.value;
        },
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
