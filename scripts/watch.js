import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';
import { join } from 'path';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
const version = pkg.version;
const date = new Intl.DateTimeFormat('en-CA', {
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hour12: false
}).format(new Date()).replace(/,/g, '');

let bannerText = readFileSync(join(process.cwd(), '/scripts/banner.txt'), 'utf8')
	.replace('###VERSION###', version)
	.replace('###DATE###', date);

const entryPoint = 'index.js';
const isBuildMode = process.argv.includes('--build');

const sharedConfig = {
	entryPoints: [entryPoint],
	bundle: true,
	treeShaking: true,
	sourcemap: true,
	logLevel: 'info',
	target: ['es2022'],
	banner: {
		js: bannerText,
	},
};

const formats = [
    { format: 'esm', outfile: 'dist/index.js' },
    { format: 'esm', minify: true, outfile: 'dist/index.mjs' },
    { format: 'iife', sourcemap: false, outfile: 'dist/webaudiofont-player.js' },
    { format: 'iife', sourcemap: false, minify: true, outfile: 'dist/webaudiofont-player.min.js' },
];

async function run() {
	try {
		if (isBuildMode) {
			await Promise.all(formats.map(config => esbuild.build({ ...sharedConfig, ...config })));
		} else {
			const contexts = await Promise.all(formats.map(config => esbuild.context({ ...sharedConfig, ...config })));
			await Promise.all(contexts.map(ctx => ctx.watch()));
		}
	} catch (error) {
		console.error('❌ Error:', error);
		process.exit(1);
	}
}

run();