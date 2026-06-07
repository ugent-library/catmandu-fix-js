import { EventEmitter } from 'events';

// increase default listener limit to avoid warnings when Jest spawns many workers
EventEmitter.defaultMaxListeners = 20;

// also bump process listeners in case some modules use process as an emitter
if (typeof process.setMaxListeners === 'function') {
  process.setMaxListeners(20);
}
