import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { TableOfContents } from './index';
import { mockHeadings } from '../../lib/navigation';
const meta = { component: TableOfContents, args: { headings: mockHeadings } } satisfies Meta<typeof TableOfContents>; export default meta; export const Default: StoryObj<typeof meta> = {};
