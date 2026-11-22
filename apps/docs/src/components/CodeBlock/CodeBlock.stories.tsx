import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { CodeBlock } from './index';
const meta = { component: CodeBlock, args: { code: 'const example = true;', language: 'ts' } } satisfies Meta<typeof CodeBlock>; export default meta; export const Default: StoryObj<typeof meta> = {};
