import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { MobileNavDrawer } from './index';
const meta = { title: 'Navigation/MobileNavDrawer', component: MobileNavDrawer, args: { open: true, onClose: () => {}, children: <nav aria-label="Docs"><a href="#intro">Introduction</a></nav> } } satisfies Meta<typeof MobileNavDrawer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Open: Story = {};
export const Closed: Story = { args: { open: false } };
