import { Middleware } from 'redux'
import { getTimeMeasureUtils } from './utils'

type EntryProcessor = (key: string, value: any) => any

const isProduction: boolean = process.env.NODE_ENV === 'production'
const prefix: string = 'Invariant failed'

// Throw an error if the condition fails
// Strip out error messages for production
// > Not providing an inline default argument for message as the result is smaller
function invariant(condition: any, message?: string) {
  if (condition) {
    return
  }
  // Condition not passed

  // In production we strip the message but still throw
  if (isProduction) {
    throw new Error(prefix)
  }

  // When not in production we allow the message to pass through
  // *This block will be removed in production builds*
  throw new Error(`${prefix}: ${message || ''}`)
}

function stringify(
  obj: any,
  serializer?: EntryProcessor,
  indent?: string | number,
  decycler?: EntryProcessor
): string {
  return JSON.stringify(obj, getSerialize(serializer, decycler), indent)
}

function getSerialize(
  serializer?: EntryProcessor,
  decycler?: EntryProcessor
): EntryProcessor {
  let stack: any[] = [],
    keys: any[] = []

  if (!decycler)
    decycler = function(_: string, value: any) {
      if (stack[0] === value) return '[Circular ~]'
      return (
        '[Circular ~.' + keys.slice(0, stack.indexOf(value)).join('.') + ']'
      )
    }

  return function(this: any, key: string, value: any) {
    if (stack.length > 0) {
      var thisPos = stack.indexOf(this)
      ~thisPos ? stack.splice(thisPos + 1) : stack.push(this)
      ~thisPos ? keys.splice(thisPos, Infinity, key) : keys.push(key)
      if (~stack.indexOf(value)) value = decycler!.call(this, key, value)
    } else stack.push(value)

    return serializer == null ? value : serializer.call(this, key, value)
  }
}

/**
 * The default `isImmutable` function.
 *
 * @public
 */
export function isImmutableDefault(value: unknown): boolean {
  return (
    typeof value !== 'object' || value === null || typeof value === 'undefined'
  )
}

export function trackForMutations(
  isImmutable: IsImmutableFunc,
  ignorePaths: string[] | undefined,
  obj: any
) {
  const trackedProperties = trackProperties(isImmutable, ignorePaths, obj)
  return {
    detectMutations() {
      return detectMutations(isImmutable, ignorePaths, trackedProperties, obj)
    }
  }
}

interface TrackedProperty {
  value: any
  children: Record<string, any>
}

function trackProperties(
  isImmutable: IsImmutableFunc,
  ignorePaths: IgnorePaths = [],
  obj: Record<string, any>,
  path: string[] = []
) {
  const tracked: Partial<TrackedProperty> = { value: obj }

  if (!isImmutable(obj)) {
    tracked.children = {}

    for (const key in obj) {
      const childPath = path.concat(key)
      if (
        ignorePaths.length &&
        ignorePaths.indexOf(childPath.join('.')) !== -1
      ) {
        continue
      }

      tracked.children[key] = trackProperties(
        isImmutable,
        ignorePaths,
        obj[key],
        childPath
      )
    }
  }
  return tracked as TrackedProperty
}

type IgnorePaths = string[]

function detectMutations(
  isImmutable: IsImmutableFunc,
  ignorePaths: IgnorePaths = [],
  trackedProperty: TrackedProperty,
  obj: any,
  sameParentRef: boolean = false,
  path: string[] = []
): { wasMutated: boolean; path?: string[] } {
  const prevObj = trackedProperty ? trackedProperty.value : undefined

  const sameRef = prevObj === obj

  if (sameParentRef && !sameRef && !Number.isNaN(obj)) {
    return { wasMutated: true, path }
  }

  if (isImmutable(prevObj) || isImmutable(obj)) {
    return { wasMutated: false }
  }

  // Gather all keys from prev (tracked) and after objs
  const keysToDetect: Record<string, boolean> = {}
  Object.keys(trackedProperty.children).forEach(key => {
    keysToDetect[key] = true
  })
  Object.keys(obj).forEach(key => {
    keysToDetect[key] = true
  })

  const keys = Object.keys(keysToDetect)
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const childPath = path.concat(key)
    if (ignorePaths.length && ignorePaths.indexOf(childPath.join('.')) !== -1) {
      continue
    }

    const result = detectMutations(
      isImmutable,
      ignorePaths,
      trackedProperty.children[key],
      obj[key],
      sameRef,
      childPath
    )

    if (result.wasMutated) {
      return result
    }
  }
  return { wasMutated: false }
}

type IsImmutableFunc = (value: any) => boolean

/**
 * Options for `createImmutableStateInvariantMiddleware()`.
 *
 * @public
 */
export interface ImmutableStateInvariantMiddlewareOptions {
  isImmutable?: IsImmutableFunc
  ignoredPaths?: string[]
  warnAfter?: number
  ignore?: string[] // @deprecated. Use ignoredPaths
}

/**
 * Creates a middleware that checks whether any state was mutated in between
 * dispatches or during a dispatch. If any mutations are detected, an error is
 * thrown.
 *
 * @param options Middleware options.
 *
 * @public
 */
export function createImmutableStateInvariantMiddleware(
  options: ImmutableStateInvariantMiddlewareOptions = {}
): Middleware {
  if (process.env.NODE_ENV === 'production') {
    return () => next => action => next(action)
  }

  let {
    isImmutable = isImmutableDefault,
    ignoredPaths,
    warnAfter = 32,
    ignore
  } = options

  // Alias ignore->ignoredPaths, but prefer ignoredPaths if present
  ignoredPaths = ignoredPaths || ignore

  const track = trackForMutations.bind(null, isImmutable, ignoredPaths)

  return ({ getState }) => {
    let state = getState()
    let tracker = track(state)

    let result
    return next => action => {
      const measureUtils = getTimeMeasureUtils(
        warnAfter,
        'ImmutableStateInvariantMiddleware'
      )

      measureUtils.measureTime(() => {
        state = getState()

        result = tracker.detectMutations()
        // Track before potentially not meeting the invariant
        tracker = track(state)

        invariant(
          !result.wasMutated,
          `A state mutation was detected between dispatches, in the path '${(
            result.path || []
          ).join(
            '.'
          )}'.  This may cause incorrect behavior. (http://redux.js.org/docs/Troubleshooting.html#never-mutate-reducer-arguments)`
        )
      })

      const dispatchedAction = next(action)

      measureUtils.measureTime(() => {
        state = getState()

        result = tracker.detectMutations()
        // Track before potentially not meeting the invariant
        tracker = track(state)

        result.wasMutated &&
          invariant(
            !result.wasMutated,
            `A state mutation was detected inside a dispatch, in the path: ${(
              result.path || []
            ).join(
              '.'
            )}. Take a look at the reducer(s) handling the action ${stringify(
              action
            )}. (http://redux.js.org/docs/Troubleshooting.html#never-mutate-reducer-arguments)`
          )
      })

      measureUtils.warnIfExceeded()

      return dispatchedAction
    }
  }
}