import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { DocsSidebar } from './index';
import { mockNavigation } from '../../lib/navigation';
const meta = { component: DocsSidebar, args: { groups: mockNavigation, activeHref: '/#overview' } } satisfies Meta<typeof DocsSidebar>;
export default meta; export const Default: StoryObj<typeof meta> = {}; export const Empty: StoryObj<typeof meta> = { args: { groups: [] } };
