import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { ThemeToggle } from './index';
const meta = { component: ThemeToggle } satisfies Meta<typeof ThemeToggle>; export default meta; export const Default: StoryObj<typeof meta> = {};
