import os
import json
import sys

# Add the parent folder of backend/ to sys.path so we can import modules
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from main import get_mock_ai_response, read_json_file, MENU_FILE

def test_mock_flow():
    print("Testing Mock AI Agent response parsing flow...")
    menu = read_json_file(MENU_FILE, [])
    
    # 1. Test greeting/empty transcript
    res1 = get_mock_ai_response("test_sid_123", "", menu)
    assert "welcome" in res1["ai_response"].lower()
    print("Test 1 (Greeting) passed!")
    
    # 2. Test ordering item
    res2 = get_mock_ai_response("test_sid_123", "I would like a Margherita Pizza and two Cheeseburgers", menu)
    assert len(res2["cart_updated"]) == 2
    assert res2["cart_updated"][0]["name"] == "Margherita Pizza"
    assert res2["cart_updated"][1]["name"] == "Cheeseburger"
    assert res2["cart_updated"][1]["qty"] == 2
    print("Test 2 (Add Items) passed!")
    
    # 3. Test choosing collection
    res3 = get_mock_ai_response("test_sid_123", "this is for collection, my name is John", menu)
    assert res3["delivery_info"]["type"] == "collection"
    print("Test 3 (Collection selection) passed!")
    
    # 4. Test finalizing order
    res4 = get_mock_ai_response("test_sid_123", "Yes, that's all. Complete my order.", menu)
    assert res4["is_completed"] is True
    print("Test 4 (Finalize Order) passed!")

if __name__ == "__main__":
    test_mock_flow()
    print("\nAll unit tests passed successfully!")
