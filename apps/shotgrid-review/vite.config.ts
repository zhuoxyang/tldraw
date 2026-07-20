import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { validateViteEnvironment } from './src/publicEnvPolicy'

export default defineConfig(({ command, mode }) => {
	const environment = {
		...loadEnv(mode, process.cwd(), ''),
		...process.env,
	}
	validateViteEnvironment(environment, command)

	return {
		plugins: [react()],
	}
})
