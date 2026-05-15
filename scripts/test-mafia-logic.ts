async function runTests() {
  console.log("Running Mafia Logic Edge Case Tests...");
  
  function tallyVotes(actions: any[]) {
    const tallies: Record<string, number> = {};
    let maxVotes = 0;
    let maxUserId = null;
    let tie = false;
    
    for (const a of actions) {
      if (!a.target_user_id) continue;
      tallies[a.target_user_id] = (tallies[a.target_user_id] || 0) + 1;
      if (tallies[a.target_user_id] > maxVotes) {
        maxVotes = tallies[a.target_user_id];
        maxUserId = a.target_user_id;
        tie = false;
      } else if (tallies[a.target_user_id] === maxVotes) {
        tie = true;
      }
    }
    
    return !tie ? maxUserId : null;
  }
  
  console.log("Test 1: Normal Vote");
  const t1 = tallyVotes([{ target_user_id: "A" }, { target_user_id: "A" }, { target_user_id: "B" }]);
  console.log("Expected A, Got:", t1);
  
  console.log("Test 2: Tie Vote");
  const t2 = tallyVotes([{ target_user_id: "A" }, { target_user_id: "A" }, { target_user_id: "B" }, { target_user_id: "B" }]);
  console.log("Expected null, Got:", t2);
  
  console.log("Test 3: Tie broken");
  const t3 = tallyVotes([{ target_user_id: "A" }, { target_user_id: "A" }, { target_user_id: "A" }, { target_user_id: "B" }, { target_user_id: "B" }]);
  console.log("Expected A, Got:", t3);

  console.log("Test 4: Skip Votes Only");
  const t4 = tallyVotes([{ target_user_id: null }, { target_user_id: null }]);
  console.log("Expected null, Got:", t4);

  console.log("Tests finished.");
}

runTests().catch(console.error);
