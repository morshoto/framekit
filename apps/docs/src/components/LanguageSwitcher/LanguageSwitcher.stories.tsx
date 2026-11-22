import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { LanguageSwitcher } from './index';
const meta = { component: LanguageSwitcher, args: { locale: 'en', slug: 'introduction' } } satisfies Meta<typeof LanguageSwitcher>; export default meta; export const Matching: StoryObj<typeof meta> = {}; export const Fallback: StoryObj<typeof meta> = { args: { slug: 'missing' } };
