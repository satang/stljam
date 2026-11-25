import { translations } from './locales.mjs';

export const languages = ['en', 'es', 'pt-BR', 'fr', 'de', 'zh-Hans'];
const languageKey = 'stljam:language';
const attributes = ['aria-label', 'title', 'placeholder'];
const formatters = new Map();

export function preferredLanguage(preferences) {
  for (const value of preferences) {
    if (typeof value !== 'string') continue;
    const tag = value.toLowerCase();
    const base = tag.split('-')[0];
    if (['en', 'es', 'fr', 'de'].includes(base)) return base;
    if (base === 'pt') return 'pt-BR';
    if (base === 'zh' && !/(?:^|-)(hant|tw|hk|mo)(?:-|$)/.test(tag)) return 'zh-Hans';
  }
  return 'en';
}

function startLanguage() {
  if (!globalThis.document) return 'en';
  try {
    const saved = globalThis.localStorage?.getItem(languageKey);
    if (languages.includes(saved)) return saved;
  } catch {
    // Browser storage can be unavailable.
  }
  return preferredLanguage(globalThis.navigator?.languages ?? []);
}

export let language = startLanguage();

export function t(message, values = {}) {
  const template = translations.get(message)?.[languages.indexOf(language) - 1] ?? message;
  return template.replace(/\{(\w+)\}/g, (token, key) => Object.hasOwn(values, key) ? String(values[key]) : token);
}

export function setLanguage(next) {
  if (!languages.includes(next)) return false;
  language = next;
  try { globalThis.localStorage?.setItem(languageKey, next); } catch { /* Keep the in-memory preference. */ }
  return true;
}

export function translatePage() {
  document.documentElement.lang = language;
  document.title = t('StlJam · 3D review');
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const attribute of attributes) {
    for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
      element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
    }
  }
}

function formatter(kind, options) {
  const key = `${language}:${kind}`;
  if (!formatters.has(key)) formatters.set(key, new Intl[kind](language === 'en' ? 'en-US' : language, options));
  return formatters.get(key);
}

export const formatNumber = value => formatter('NumberFormat', { maximumFractionDigits: 2 }).format(value);
export const formatDate = value => formatter('DateTimeFormat', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
