import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { FallbackNotice } from './index';
const meta = { component: FallbackNotice, args: { message: 'The requested translation is unavailable; showing the overview.', fallback: true } } satisfies Meta<typeof FallbackNotice>; export default meta; export const Default: StoryObj<typeof meta> = {};
