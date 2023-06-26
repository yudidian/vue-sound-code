const set = new Set([1,2,3,6])

console.log(Object.prototype.toString.call(set))
console.log(set.values()) // 返回一个迭代器对象
console.log(set.keys()) // 返回一个迭代器对象
console.log(set.entries())
console.log(set.values() === set.keys()) // false

for (const val of set.entries()) {
  console.log(val)
}
