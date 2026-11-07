import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { SiteHeader } from './index';
const meta = { component: SiteHeader, args: { onMenu: () => {} }, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof SiteHeader>; export default meta; export const Default: StoryObj<typeof meta> = {};
