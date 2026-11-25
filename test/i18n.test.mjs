import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatNumber, languages, preferredLanguage, setLanguage, t } from '../src/web/i18n.mjs';
import { translations } from '../src/web/locales.mjs';

test('chooses supported locales safely and falls back to English', () => {
  assert.equal(preferredLanguage(['ja-JP', 'es-AR']), 'es');
  assert.equal(preferredLanguage(['pt-PT']), 'pt-BR');
  assert.equal(preferredLanguage(['zh-CN']), 'zh-Hans');
  assert.equal(preferredLanguage(['zh-Hant-TW', 'zh-HK', 'unknown']), 'en');
  assert.equal(setLanguage('__proto__'), false);
  assert.equal(t('Help'), 'Help');
});

test('has translations for every bound UI label and preserves interpolated data', async () => {
  const html = await readFile(new URL('../src/web/index.html', import.meta.url), 'utf8');
  for (const [, label] of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) {
    assert.ok(translations.has(label.replaceAll('&amp;', '&')), label);
  }
  for (const [message, localized] of translations) {
    assert.equal(localized.length, languages.length - 1, message);
    assert.ok(localized.every(Boolean), message);
    const tokens = new Set(message.match(/\{\w+\}/g));
    for (const label of localized) for (const token of label.match(/\{\w+\}/g) ?? []) assert.ok(tokens.has(token), token);
  }
  assert.equal(setLanguage('es'), true);
  assert.equal(t('Hide {name}', { name: '<b>{count}</b>' }), 'Ocultar <b>{count}</b>');
  assert.equal(formatNumber(3.5), '3,5');
  assert.equal(setLanguage('en'), true);
});
