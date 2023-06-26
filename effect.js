// 副作用桶
import {deepClone} from "./utils/utils.js";
import Keywords from "./utils/keywords.js";
import keywords from "./utils/keywords.js";

const bucket = new WeakMap()
// 副作用栈
const effectStack = []
// 执行任务队列
const jobQueue = new Set()
const promise = Promise.resolve()
let isFlushing = false
let activeEffect = null

// 重写数组中的部分方法
const arrayInstrumentation = {}
// 默认 允许track
let shouldTrack = true
const rewriteArrayKeyByReturn = ['includes', 'indexOf', 'lastIndexOf']
const rewriteArrayKeyByLength = ['push', 'pop', 'shift', 'unshift', 'splice']
const mutableInstrumentations = {
  add(val){
    const target = this[keywords.RAW]
    const res = target.add(val)
    trigger(target, val, keywords.ADD)
    return res
  }
}
rewriteArrayKeyByLength.forEach(key => {
  const originMethod = Array.prototype[key]
  arrayInstrumentation[key] = function (...args) {
    shouldTrack = false
    let res = originMethod.apply(this, args)
    if (!res || res === -1) {
      res = originMethod.apply(this.raw, args)
    }
    shouldTrack = true
    return res
  }
})
rewriteArrayKeyByReturn.forEach(key => {
  const originMethod = Array.prototype[key]
  arrayInstrumentation[key] = function (...args) {
    let res = originMethod.apply(this, args)
    if (!res || res === -1) {
      res = originMethod.apply(this.raw, args)
    }
    return res
  }
})

function effect(fn, options = {lazy: false}) {
  const effectFn = () => {
    clearUp(effectFn)
    activeEffect = effectFn
    // effectStack 的作用是保证嵌套effect时可以正确的找到对应的副作用函数
    effectStack.push(effectFn)
    // fn 函数的返回结果
    const res = fn()
    effectStack.pop()
    activeEffect = effectStack[effectStack.length - 1]
    return res
  }
  effectFn.options = options
  effectFn.deps = []
  if (!options.lazy) {
    effectFn()
  }
  return effectFn
}

// 通用函数-start

function flushJob() {
  if (isFlushing) return
  isFlushing = true
  promise.then(() => {
    jobQueue.forEach(fn => fn())
  }).finally(() => {
    isFlushing = false
  })
}

function track(target, key) {
  // 获取 target 对应的 map 容器
  let desMap = bucket.get(target)
  if (!desMap) {
    bucket.set(target, desMap = new Map)
  }
  // 获取对应 key 的 set 容器
  let desSet = desMap.get(key)
  if (!desSet) {
    desMap.set(key, desSet = new Set())
  }
  // 当前副作用函数为空或者不允许track则返回
  if (!activeEffect || !shouldTrack) {
    return
  }
  desSet.add(activeEffect)
  activeEffect.deps.push(desSet)
}

function trigger(target, key, type, newVal) {
  const desMap = bucket.get(target)
  if (!desMap) {
    return true
  }
  const effects = desMap.get(key)
  const effectToRun = new Set()
  if (type === keywords.ADD && Array.isArray(target)) {
    // 获取与 length 相关副作用函数
    const lengthEffects = desMap.get(keywords.LENGTH)
    lengthEffects && lengthEffects.forEach(fn => {
      if (activeEffect !== fn) {
        effectToRun.add(fn)
      }
    })
  }
  if (type === keywords.ADD || type === keywords.DELETE) {
    // 获取与 iterate 相关副作用函数
    const iterateEffects = desMap.get(keywords.ITERATE_KEY)
    iterateEffects && iterateEffects.forEach(fn => {
      if (activeEffect !== fn) {
        effectToRun.add(fn)
      }
    })
  }
  if (key === keywords.LENGTH && Array.isArray(target)) {
    desMap.forEach((effects, key) => {
      if (key >= newVal) {
        effects.forEach(effectFn => {
          if (effectFn !== activeEffect) {
            effectToRun.add(effectFn)
          }
        })
      }
    })
  }
  effects && effects.forEach(fn => {
    // 避免触发的时候 fn 和 activeEffect 相同而导致无限递归
    if (activeEffect !== fn) {
      effectToRun.add(fn)
    }
  })
  effectToRun && effectToRun.forEach(fn => {
    const scheduler = fn.options.scheduler
    if (scheduler) {
      scheduler(fn)
    } else {
      fn()
    }
  })
}

// 清除函数依赖
function clearUp(effectFn) {
  for (let i = 0; i < effectFn.deps.length; i++) {
    const desSet = effectFn.deps[i]
    desSet.delete(effectFn)
  }
  effectFn.deps.length = 0
}

function computed(getter) {
  // 对值进行缓存处理
  let value = null
  let dirty = true
  const effectFn = effect(getter, {
    lazy: true,
    scheduler() {
      dirty = true
      trigger(obj, "value")
    }
  })
  const obj = {
    get value() {
      if (dirty) {
        value = effectFn()
        dirty = false
      }
      track(obj, "value")
      return value
    }
  }
  return obj
}

// 递归读取值属性
function traverse(source, seen = new Set()) {
  if (typeof source !== 'object' || source === null || seen.has(source)) {
    return
  }
  seen.add(source)
  for (const key in source) {
    traverse(source[key], seen)
  }
  return source
}

function watch(source, callback, options = {
  immediate: false,
  flush: 'pre'
}) {
  let getter, oldValue, newValue, cleanup
  if (typeof source === 'function') {
    getter = source
  } else {
    getter = () => traverse(source)
  }
  const onInvalidate = (fn) => {
    cleanup = fn
  }
  const job = () => {
    newValue = deepClone(effectFn())
    if (cleanup) {
      cleanup()
    }
    callback(oldValue, newValue, onInvalidate)
    oldValue = newValue
  }
  const effectFn = effect(() => getter(), {
    scheduler: () => {
      if (options.flush === "post") {
        const p = Promise.resolve()
        p.then(job)
      } else {
        job()
      }
    },
    lazy: true
  })
  if (options.immediate) {
    job()
  } else {
    oldValue = deepClone(effectFn())
  }
}

function createReactive(obj, isShallow = false, isReadonly = false) {
  return new Proxy(obj, {
    get(target, key, receiver) {
      if (key === keywords.RAW) {
        return target
      }
      const typeStr = Object.prototype.toString.call(target)
      // 代理类型是 set 或者 map
      if (typeStr === keywords.setList || typeStr === keywords.mapList) {
        if (key === keywords.size) {
          track(target, keywords.ITERATE_KEY)
          return Reflect.get(target, key, target)
        }
        return mutableInstrumentations[key]
      }
      if (Array.isArray(target) && arrayInstrumentation.hasOwnProperty(key)) {
        return Reflect.get(arrayInstrumentation, key, receiver)
      }
      const res = Reflect.get(target, key, receiver)
      // 只读属性和symbol类型不需要被追踪
      if (!isReadonly && typeof key !== 'symbol') {
        track(target, key)
      }
      if (isShallow) {
        return res
      }
      if (typeof res === "object" && res !== null) {
        return isReadonly ? readonly(res) : reactive(res)
      }
      return res
    },
    set(target, key, value, receiver) {
      console.log(target)
      if (isReadonly) {
        console.error(`${key}为只读属性，不可修改`)
        return true
      }
      const oldValue = target[key]
      const type = Array.isArray(target) ? Number(key) < value.length ? keywords.ADD : keywords.SET : Object.prototype.hasOwnProperty.call(target, key) ? keywords.SET : keywords.ADD
      Reflect.set(target, key, value, receiver)
      if (target === receiver[keywords.RAW]) {
        // 值发生变化时才会触发对应副作用函数
        if (oldValue !== value && (oldValue === oldValue || value === value)) {
          trigger(target, key, type, value)
        }
      }
      return true
    },
    deleteProperty(target, key) {
      if (isReadonly) {
        console.error(`${key}为只读属性，不可修改`)
        return true
      }
      const isOwnKey = Object.prototype.hasOwnProperty.call(target, key)
      const res = Reflect.deleteProperty(target, key)
      if (res && isOwnKey) {
        trigger(target, key, keywords.DELETE)
      }
      return res
    },
    has(target, p) {
      track(target, p)
      return Reflect.has(target, p)
    },
    ownKeys(target) {
      track(target, Array.isArray(target) ? keywords.LENGTH : Keywords.ITERATE_KEY)
      return Reflect.ownKeys(target)
    },
    // apply(target, thisArg, argArray) { // target 为函数时有效
    //   Reflect.apply(target, thisArg, argArray)
    // }
  })
}


const reactiveMap = new Map()

function reactive(obj) {
  const exitReactive = reactiveMap.get(obj)
  if (exitReactive) {
    return exitReactive
  }
  const proxy = createReactive(obj)
  reactiveMap.set(obj, proxy)
  return proxy
}

function shallowReactive(obj) {
  return createReactive(obj, true)
}

function shallowReadonly(obj) {
  return createReactive(obj, true, true)
}

function readonly(obj) {
  return createReactive(obj, false, true)
}

// 通用函数-end

const p = reactive(new Set([1, 2, 3]))

effect(() => {
  // 在副作用函数内访问 size 属性
  console.log(p.size)
})
// 添加值为 1 的元素，应该触发响应
p.add(4)



