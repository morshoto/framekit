import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Breadcrumbs } from './index';
const meta = { component: Breadcrumbs, args: { current: 'Overview' } } satisfies Meta<typeof Breadcrumbs>; export default meta; export const Default: StoryObj<typeof meta> = {};
