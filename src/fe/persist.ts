import { createSignal, type Accessor, type Setter } from 'solid-js';
import { createStore, type SetStoreFunction, type Store } from 'solid-js/store';
import { makePersisted, type PersistenceOptions } from '@solid-primitives/storage';

/**
 * Typed wrappers around @solid-primitives/storage makePersisted.
 * Works around a generic incompatibility with Solid 1.9 Setter type.
 */

export function persistedSignal<T>(
  initial: T,
  options: PersistenceOptions<T, undefined>,
): [Accessor<T>, Setter<T>] {
  return makePersisted(createSignal<T>(initial), options);
}

export function persistedStore<T extends object>(
  initial: T,
  options: PersistenceOptions<T, undefined>,
): [Store<T>, SetStoreFunction<T>] {
  return makePersisted(createStore(initial), options);
}
