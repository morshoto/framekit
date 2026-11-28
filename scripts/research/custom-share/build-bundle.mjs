// Build only under the OS temporary directory. Never register or launch the bundle.
import { execFile } from 'node:child_process';
import { copyFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const requested = process.argv[2];
if (!requested || process.argv.length !== 3 || !requested.endsWith('.app')) throw new Error('supply a new temporary .app path');
const parent = await realpath(dirname(resolve(requested)));
const tempRoot = await realpath(tmpdir());
const rel = relative(tempRoot, parent);
if (rel.startsWith('..') || rel.startsWith('/')) throw new Error('bundle must be under temporary directory');
const bundle = join(parent, basename(requested));
await mkdir(bundle); // create-only; never modify an existing bundle
const contents = join(bundle, 'Contents');
const macos = join(contents, 'MacOS');
const resources = join(contents, 'Resources');
await mkdir(macos, { recursive: true });
await mkdir(resources);
const here = dirname(fileURLToPath(import.meta.url));
await copyFile(join(here, 'swift-app', 'Info.plist'), join(contents, 'Info.plist'));
await copyFile(join(here, 'swift-app', 'ShareResearch.sdef'), join(resources, 'ShareResearch.sdef'));
await promisify(execFile)('xcrun', ['swiftc', join(here, 'SwiftReceiver.swift'), join(here, 'swift-app', 'main.swift'), '-o', join(macos, 'ShareResearch')]);
