import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Button } from './index';

const meta = { title: 'Controls/Button', component: Button, args: { children: 'Continue', onClick: fn() } } satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Primary: Story = { play: async ({ canvasElement, args }) => { const button = within(canvasElement).getByRole('button'); await userEvent.click(button); await expect(args.onClick).toHaveBeenCalled(); } };
export const Secondary: Story = { args: { variant: 'secondary' } };
export const Disabled: Story = { args: { disabled: true } };
export const Loading: Story = { args: { loading: true, children: 'Saving' } };
