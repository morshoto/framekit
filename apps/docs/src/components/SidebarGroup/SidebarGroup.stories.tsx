import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { SidebarGroup } from './index';
const meta = { component: SidebarGroup, args: { group: { title: 'Getting Started', items: [{ title: 'A very long example navigation item', href: '/#overview' }] }, activeHref: '/#overview' } } satisfies Meta<typeof SidebarGroup>;
export default meta; export const Active: StoryObj<typeof meta> = {};
