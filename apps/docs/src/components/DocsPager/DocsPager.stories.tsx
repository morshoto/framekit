import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { DocsPager } from './index';
const meta = { component: DocsPager, args: { next: { title: 'First steps', href: '/#first-steps' } } } satisfies Meta<typeof DocsPager>; export default meta; export const Default: StoryObj<typeof meta> = {};
