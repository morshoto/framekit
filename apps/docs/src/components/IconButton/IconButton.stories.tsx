import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { IconButton } from './index';
const meta = { title: 'Controls/IconButton', component: IconButton, args: { label: 'Open menu', children: '☰' } } satisfies Meta<typeof IconButton>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Outlined: Story = { args: { variant: 'outlined' } };
export const Disabled: Story = { args: { disabled: true } };
export const LongAccessibleLabel: Story = { args: { label: 'Open the documentation navigation menu' } };
