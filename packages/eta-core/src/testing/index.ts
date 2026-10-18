/** Test-only entry: fakes, storage contracts, and real-model smoke/config helpers. */
export { type SelectedProvider, selectProvider } from "./eta-config";
export {
  type FakeCompaction,
  fakeCompaction,
  type FakeCompactionOptions,
} from "./fake-compaction";
export {
  assistantMessage,
  type FakeModels,
  fakeModels,
  type FakeModelsOptions,
  type RecordedCall,
} from "./fake-provider";
export { type ModelSpec, type ProviderSpec, realModels } from "./real-models";
export {
  storageContract,
  type StorageContractHandle,
  type StorageContractOptions,
  type StorageFactory,
} from "./storage-contract";
