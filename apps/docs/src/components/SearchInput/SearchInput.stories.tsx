import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { SearchInput } from './index';
const meta = { component: SearchInput, args: { value:'', onChange: () => {} } } satisfies Meta<typeof SearchInput>; export default meta; export const Empty: StoryObj<typeof meta> = {}; export const Japanese: StoryObj<typeof meta> = { args: { value: '青いランタン' } };
