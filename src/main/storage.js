(() => {
  "use strict";
  const ctx = window.__WTI_CONTEXT;
  if (!ctx?.active) return;

  const localProxy = virtualStorage(ctx.rawLocalStorage, ctx.prefix);
  const sessionProxy = virtualStorage(ctx.rawSessionStorage, ctx.prefix);
  replaceWindowStorage("localStorage", localProxy);
  replaceWindowStorage("sessionStorage", sessionProxy);
  isolateStorageEvents(localProxy, sessionProxy);
  isolateIndexedDb();
  isolateOpfs();

  ctx.capabilities.webStorage = true;
  ctx.capabilities.indexedDb = true;

  function virtualStorage(raw, prefix) {
    const target = Object.create(Storage.prototype);
    const logicalKeys = () => {
      const keys = [];
      for (let index = 0; index < raw.length; index += 1) {
        const key = raw.key(index);
        if (key?.startsWith(prefix)) keys.push(key.slice(prefix.length));
      }
      return keys;
    };

    return new Proxy(target, {
      get(_target, property) {
        if (property === "length") return logicalKeys().length;
        if (property === "key") return (index) => logicalKeys()[Number(index)] ?? null;
        if (property === "getItem") return (key) => raw.getItem(prefix + String(key));
        if (property === "setItem") return (key, value) => raw.setItem(prefix + String(key), String(value));
        if (property === "removeItem") return (key) => raw.removeItem(prefix + String(key));
        if (property === "clear") return () => logicalKeys().forEach((key) => raw.removeItem(prefix + key));
        if (property === Symbol.toStringTag) return "Storage";
        if (typeof property === "string") {
          const value = raw.getItem(prefix + property);
          if (value !== null) return value;
        }
        return Reflect.get(target, property);
      },
      set(_target, property, value) {
        if (typeof property === "string") raw.setItem(prefix + property, String(value));
        return true;
      },
      deleteProperty(_target, property) {
        if (typeof property === "string") raw.removeItem(prefix + property);
        return true;
      },
      has(targetObject, property) {
        return typeof property === "string" && raw.getItem(prefix + property) !== null
          ? true
          : Reflect.has(targetObject, property);
      },
      ownKeys: logicalKeys,
      getOwnPropertyDescriptor(_target, property) {
        if (typeof property !== "string") return undefined;
        const value = raw.getItem(prefix + property);
        return value === null ? undefined : { value, writable: true, enumerable: true, configurable: true };
      }
    });
  }

  function replaceWindowStorage(name, value) {
    Object.defineProperty(window, name, { configurable: false, enumerable: true, get: () => value });
  }

  function isolateStorageEvents(localArea, sessionArea) {
    const isolatedEvents = new WeakSet();
    EventTarget.prototype.addEventListener.call(window, "storage", (event) => {
      if (isolatedEvents.has(event)) return;
      event.stopImmediatePropagation();
      if (!event.key?.startsWith(ctx.prefix)) return;

      const isolatedEvent = new StorageEvent("storage", {
        key: event.key.slice(ctx.prefix.length),
        oldValue: event.oldValue,
        newValue: event.newValue,
        url: event.url,
        storageArea: null
      });
      Object.defineProperty(isolatedEvent, "storageArea", {
        value: event.storageArea === ctx.rawSessionStorage ? sessionArea : localArea
      });
      isolatedEvents.add(isolatedEvent);
      window.dispatchEvent(isolatedEvent);
    }, { capture: true });
  }

  function isolateIndexedDb() {
    const factoryPrototype = IDBFactory.prototype;
    const nativeOpen = factoryPrototype.open;
    const nativeDelete = factoryPrototype.deleteDatabase;
    const nativeDatabases = factoryPrototype.databases;

    factoryPrototype.open = function open(name, version) {
      return version === undefined
        ? nativeOpen.call(this, ctx.prefix + String(name))
        : nativeOpen.call(this, ctx.prefix + String(name), version);
    };
    factoryPrototype.deleteDatabase = function deleteDatabase(name) {
      return nativeDelete.call(this, ctx.prefix + String(name));
    };
    if (typeof nativeDatabases === "function") {
      factoryPrototype.databases = async function databases() {
        const entries = await nativeDatabases.call(this);
        return entries
          .filter((entry) => entry.name?.startsWith(ctx.prefix))
          .map((entry) => ({ ...entry, name: entry.name.slice(ctx.prefix.length) }));
      };
    }

    const nameDescriptor = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, "name");
    if (nameDescriptor?.get && nameDescriptor.configurable) {
      Object.defineProperty(IDBDatabase.prototype, "name", {
        configurable: true,
        enumerable: nameDescriptor.enumerable,
        get() {
          const physicalName = nameDescriptor.get.call(this);
          return physicalName.startsWith(ctx.prefix) ? physicalName.slice(ctx.prefix.length) : physicalName;
        }
      });
    }
  }

  function isolateOpfs() {
    if (!navigator.storage?.getDirectory) {
      ctx.capabilities.opfs = false;
      return;
    }
    const nativeGetDirectory = navigator.storage.getDirectory.bind(navigator.storage);
    Object.defineProperty(navigator.storage, "getDirectory", {
      configurable: true,
      value: async () => {
        const root = await nativeGetDirectory();
        return root.getDirectoryHandle(`wti-${ctx.sessionId}`, { create: true });
      }
    });
    ctx.capabilities.opfs = true;
  }
})();
