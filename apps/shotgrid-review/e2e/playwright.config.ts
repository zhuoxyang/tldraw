import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const e2eDirectory = path.dirname(fileURLToPath(import.meta.url))
const appDirectory = path.resolve(e2eDirectory, '..')
const baseURL = 'http://127.0.0.1:5460'

export default defineConfig({
	expect: { timeout: 10_000 },
	forbidOnly: Boolean(process.env.CI),
	fullyParallel: false,
	outputDir: path.join(os.tmpdir(), 'shotgrid-review-playwright-results'),
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] },
		},
	],
	reporter: 'list',
	retries: process.env.CI ? 1 : 0,
	testDir: e2eDirectory,
	testMatch: /image-review\.e2e\.ts/,
	timeout: 90_000,
	use: {
		acceptDownloads: true,
		baseURL,
		headless: true,
		screenshot: 'only-on-failure',
		trace: 'on-first-retry',
		video: 'retain-on-failure',
		viewport: { height: 800, width: 1280 },
	},
	webServer: {
		command: 'yarn vite --host 127.0.0.1 --port 5460 --strictPort',
		cwd: appDirectory,
		reuseExistingServer: false,
		timeout: 120_000,
		url: `${baseURL}/e2e/image-review.html`,
	},
	workers: 1,
})
