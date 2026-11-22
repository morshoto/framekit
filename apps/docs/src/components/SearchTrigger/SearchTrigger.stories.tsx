import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { SearchTrigger } from './index';
const meta = { component: SearchTrigger, args: { disabled: true } } satisfies Meta<typeof SearchTrigger>; export default meta; export const Placeholder: StoryObj<typeof meta> = {};
