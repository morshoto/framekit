export const locales = ['en', 'ja'] as const;
export type Locale = typeof locales[number];
export function isLocale(value: string): value is Locale { return locales.some(locale => locale === value); }
