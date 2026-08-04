import assert from 'node:assert/strict';
import test from 'node:test';
import viteConfig from './vite.config';

test('development proxies API and uploaded assets to the Node gateway', () => {
  assert.equal(typeof viteConfig, 'object');
  const proxy = (viteConfig as { server?: { proxy?: Record<string, unknown> } }).server?.proxy;
  assert.deepEqual(proxy?.['/api'], {
    target: 'http://localhost:9005',
    changeOrigin: true,
  });
  assert.deepEqual(proxy?.['/uploads'], {
    target: 'http://localhost:9005',
    changeOrigin: true,
  });
});
