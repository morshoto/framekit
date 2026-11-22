import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { EmptySearchState } from './index';
const meta = { component: EmptySearchState, args: { message:'No results found.' } } satisfies Meta<typeof EmptySearchState>; export default meta; export const Empty: StoryObj<typeof meta> = {};
