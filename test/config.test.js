import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults when the environment is empty', () => {
    const config = loadConfig({});

    assert.equal(config.port, 3000);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.logLevel, 'info');
  });

  it('reads values from the environment', () => {
    const config = loadConfig({ PORT: '8080', HOST: '0.0.0.0', LOG_LEVEL: 'debug' });

    assert.equal(config.port, 8080);
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.logLevel, 'debug');
  });

  it('treats an empty string as absent rather than as a malformed value', () => {
    const config = loadConfig({ PORT: '', HOST: '', LOG_LEVEL: '' });

    assert.equal(config.port, 3000);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.logLevel, 'info');
  });

  it('returns a frozen object so config cannot drift at runtime', () => {
    const config = loadConfig({});

    assert.ok(Object.isFrozen(config));
    assert.throws(() => {
      // @ts-expect-error — deliberately violating readonly to prove the freeze holds.
      config.port = 9999;
    }, TypeError);
  });

  for (const bad of ['0', '65536', '-1', 'abc', '3000.5']) {
    it(`rejects PORT=${JSON.stringify(bad)} by name`, () => {
      assert.throws(() => loadConfig({ PORT: bad }), (err) => {
        assert.ok(err instanceof RangeError);
        assert.match(err.message, /PORT/);
        return true;
      });
    });
  }

  it('rejects an unknown LOG_LEVEL by name', () => {
    assert.throws(() => loadConfig({ LOG_LEVEL: 'verbose' }), (err) => {
      assert.ok(err instanceof TypeError);
      assert.match(err.message, /LOG_LEVEL/);
      return true;
    });
  });
});
