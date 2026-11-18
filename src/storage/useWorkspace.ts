import { useCallback, useEffect, useState } from 'react'
import { openWorkspace, type WorkspaceRepository } from './repository'
import type { Workspace } from './workspace'

export function useWorkspace() {
  const [state, setState] = useState<Workspace>()
  const [repository, setRepository] = useState<WorkspaceRepository>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    let unsubscribe = () => {}
    const receive = (current: Workspace) => {
      if (active) setState(previous => !previous || current.revision >= previous.revision ? current : previous)
    }
    void openWorkspace().then(async store => {
      if (!active) return
      setRepository(store)
      unsubscribe = store.subscribe(() => { void store.load().then(receive).catch(() => setError('Could not update data from the other tab.')) })
      receive(await store.load())
    }).catch(() => { if (active) setError('Could not open local data. Reload to try again.') })
    return () => { active = false; unsubscribe() }
  }, [])

  const commit = useCallback(async (change: (workspace: Workspace) => Workspace) => {
    try {
      const store = await openWorkspace()
      const current = await store.update(change)
      setState(previous => !previous || current.revision >= previous.revision ? current : previous)
      setError('')
      return true
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save changes locally.')
      return false
    }
  }, [])
  return { state, repository, commit, error, clearError: () => setError('') }
}

export type Commit = ReturnType<typeof useWorkspace>['commit']
