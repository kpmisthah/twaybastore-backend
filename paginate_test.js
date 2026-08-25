const paginate = (items, page, limit) => {
  const offset = (page - 1) * limit;
  return items.slice(offset, offset + limit);
};
console.log(paginate([1,2,3,4,5], 1, 2));
