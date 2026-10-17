/**
 * Isomorphic, Zero-Dependency EventEmitter.
 * Compatible with Node.js and all modern web browsers.
 *
 * @module EventEmitter
 */
export class EventEmitter {
  constructor() {
    this._events = new Map();
  }

  /**
   * Registers an event listener callback.
   * @param {string} event
   * @param {Function} listener
   * @returns {this}
   */
  on(event, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Listener must be a function');
    }
    if (!this._events.has(event)) {
      this._events.set(event, []);
    }
    this._events.get(event).push(listener);
    return this;
  }

  /**
   * Alias for `on`.
   */
  addListener(event, listener) {
    return this.on(event, listener);
  }

  /**
   * Registers a one-time event listener callback.
   * @param {string} event
   * @param {Function} listener
   * @returns {this}
   */
  once(event, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('Listener must be a function');
    }
    const wrapper = (...args) => {
      this.off(event, wrapper);
      listener.apply(this, args);
    };
    wrapper.listener = listener;
    return this.on(event, wrapper);
  }

  /**
   * Removes an event listener.
   * @param {string} event
   * @param {Function} [listener] If omitted, removes all listeners for the event.
   * @returns {this}
   */
  off(event, listener) {
    const list = this._events.get(event);
    if (!list) return this;
    if (!listener) {
      this._events.delete(event);
      return this;
    }
    const idx = list.findIndex(f => f === listener || f.listener === listener);
    if (idx !== -1) {
      list.splice(idx, 1);
    }
    if (list.length === 0) {
      this._events.delete(event);
    }
    return this;
  }

  /**
   * Alias for `off`.
   */
  removeListener(event, listener) {
    return this.off(event, listener);
  }

  /**
   * Removes all listeners for a given event, or all events if none specified.
   * @param {string} [event]
   * @returns {this}
   */
  removeAllListeners(event) {
    if (event) {
      this._events.delete(event);
    } else {
      this._events.clear();
    }
    return this;
  }

  /**
   * Synchronously invokes all listeners for an event with the supplied arguments.
   * @param {string} event
   * @param {...any} args
   * @returns {boolean} True if listeners were invoked, false otherwise.
   */
  emit(event, ...args) {
    const list = this._events.get(event);
    if (!list || list.length === 0) {
      if (event === 'error') {
        const err = args[0];
        if (err instanceof Error && typeof process !== 'undefined' && process.listeners && process.listeners('uncaughtException').length > 0) {
          throw err;
        }
      }
      return false;
    }
    const copy = [...list];
    for (const fn of copy) {
      try {
        fn.apply(this, args);
      } catch (err) {
        console.error(`Error in EventEmitter handler for "${event}":`, err);
      }
    }
    return true;
  }

  /**
   * Returns the count of registered listeners for an event.
   * @param {string} event
   * @returns {number}
   */
  listenerCount(event) {
    return this._events.get(event)?.length || 0;
  }
}

export default EventEmitter;
