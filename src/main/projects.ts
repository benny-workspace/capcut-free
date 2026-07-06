import { promises as fs } from 'fs'
import { join } from 'path'
import type { Project } from '../shared/model'
import { appRoot } from './ffmpeg'

export function dataDir(): string {
  return join(appRoot(), 'data')
}

export function projectsDir(): string {
  return join(dataDir(), 'projects')
}

export function cacheDir(): string {
  return join(dataDir(), 'cache')
}

export function proxiesDir(): string {
  return join(cacheDir(), 'proxies')
}

export async function ensureDataDirs(): Promise<void> {
  await fs.mkdir(projectsDir(), { recursive: true })
  await fs.mkdir(proxiesDir(), { recursive: true })
}

const lastPointer = (): string => join(dataDir(), 'last-project.txt')

export async function saveProject(project: Project): Promise<void> {
  project.modifiedAt = new Date().toISOString()
  const file = join(projectsDir(), `${project.id}.json`)
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(project, null, 1), 'utf8')
  await fs.rename(tmp, file).catch(async () => {
    // rename over existing can fail on some Windows setups; fall back to copy
    await fs.copyFile(tmp, file)
    await fs.unlink(tmp).catch(() => {})
  })
  await fs.writeFile(lastPointer(), project.id, 'utf8')
}

export async function loadLastProject(): Promise<Project | null> {
  try {
    const id = (await fs.readFile(lastPointer(), 'utf8')).trim()
    const raw = await fs.readFile(join(projectsDir(), `${id}.json`), 'utf8')
    return JSON.parse(raw) as Project
  } catch {
    return null
  }
}
