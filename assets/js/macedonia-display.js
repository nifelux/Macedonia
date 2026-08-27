/* Macedonia presentation mapping. This file changes rendered text only and never changes database records, IDs, RPC calls, or routes. */
(function(){
  var names=["Diesel Supply Package","Lubricants Reserve Package","LPG Distribution Package","Bulk Storage Allocation","Marine Fuel Supply Package"];
  var descriptions=[
    "A diesel-focused oil package displayed from the existing product record.",
    "A lubricants and workshop-supply package displayed from the existing product record.",
    "An LPG distribution package displayed from the existing product record.",
    "A bulk storage and logistics package displayed from the existing product record.",
    "A marine fuel supply package displayed from the existing product record."
  ];
  function position(product,tier){
    if(Number.isFinite(Number(tier))) return Math.max(0,Math.min(names.length-1,Number(tier)));
    var raw=String(product&&product.name||""); var sum=0;
    for(var i=0;i<raw.length;i++) sum+=raw.charCodeAt(i);
    return sum%names.length;
  }
  window.MacedoniaDisplay={
    packageName:function(product,tier){return names[position(product,tier)];},
    packageDescription:function(product,tier){return descriptions[position(product,tier)];},
    packageTier:function(level){return "Package Tier "+(Number(level)||0);}
  };
})();
