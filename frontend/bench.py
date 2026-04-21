import asyncio
import websockets
import hashlib
import random
import string
import time
import argparse
import json

async def crack_hash_via_websocket(uri, md5_hash):
    """
    Connects to the WebSocket server, sends a hash, and waits for the result.
    Returns the server's JSON response.
    """
    async with websockets.connect(uri) as websocket:
        # Consume the initial connection message from the server
        # The server sends: {"message":"WebSocket connection established. Send hash to crack."}
        _ = await websocket.recv() 
        # You can optionally print this:
        # initial_message_json = json.loads(initial_message_str)
        # print(f"DEBUG: Server welcome: {initial_message_json.get('message')}")

        payload = json.dumps({"hash": md5_hash})
        # print(f"DEBUG: Sending payload: {payload}") # Optional debug
        await websocket.send(payload)
        
        response_str = await websocket.recv()
        # print(f"DEBUG: Received response string: {response_str}") # Optional debug
        response_json = json.loads(response_str)
        return response_json

def generate_random_word(length, use_lower, use_upper, use_digits):
    """
    Generates a random word of a given length using specified character sets.
    """
    char_pool = ""
    if use_lower:
        char_pool += string.ascii_lowercase
    if use_upper:
        char_pool += string.ascii_uppercase
    if use_digits:
        char_pool += string.digits

    if not char_pool:
        # This should be caught by argparse validation in main(),
        # but it's a safeguard.
        raise ValueError("Character pool cannot be empty. Select at least one character type.")

    return ''.join(random.choice(char_pool) for _ in range(length))

async def main():
    parser = argparse.ArgumentParser(
        description=(
            "MD5 Hash Cracking Test Client via WebSocket.\n"
            "Generates random words, hashes them, sends to a WebSocket server,\n"
            "and measures time for successful cracks where the server returns the original word."
        ),
        formatter_class=argparse.RawTextHelpFormatter # Allows newlines in description
    )
    parser.add_argument(
        "-l", "--length", type=int, required=True, 
        help="Number of characters in the words to generate."
    )
    parser.add_argument(
        "-t", "--trials", type=int, required=True, 
        help="Number of words/hashes to test."
    )
    parser.add_argument(
        "--lower", action='store_true', 
        help="Include lowercase letters (a-z) in generated words."
    )
    parser.add_argument(
        "--upper", action='store_true', 
        help="Include uppercase letters (A-Z) in generated words."
    )
    parser.add_argument(
        "--digits", action='store_true', 
        help="Include digits (0-9) in generated words."
    )
    parser.add_argument(
        "--server_url", type=str, default="ws://localhost:3000", 
        help="WebSocket server URL (default: ws://localhost:3000)."
    )

    args = parser.parse_args()

    if not (args.lower or args.upper or args.digits):
        parser.error("No character types selected. Please use at least one of --lower, --upper, or --digits.")

    print(f"Starting MD5 cracking test client...")
    print(f"  Target Server: {args.server_url}")
    print(f"  Number of Trials: {args.trials}")
    print(f"  Word Length: {args.length}")
    char_set_desc = []
    if args.lower: char_set_desc.append("lowercase")
    if args.upper: char_set_desc.append("uppercase")
    if args.digits: char_set_desc.append("digits")
    print(f"  Character Set for Word Generation: {', '.join(char_set_desc)}")
    print("-" * 40)

    # Note about server capabilities based on the provided server.js context
    print("INFO: The target server's hashcat (WebSocket endpoint, from provided server.js) appears configured for:")
    print("      - MD5 hashes (-m 0)")
    print("      - Character set: lowercase and uppercase letters (-1 ?l?u)")
    print("      - Word lengths: 5 to 10 characters (--increment-min 5, up to 10 '?1' in mask)")
    print("      For successful cracks and meaningful timing, generated words should align with these settings.")
    print("      If generated words use digits or are outside this length, the server may report 'Non trovato'.")
    print("-" * 40)

    successful_cracks = 0
    total_time_for_successful_cracks = 0.0
    
    completed_trials = 0

    for i in range(args.trials):
        completed_trials = i + 1
        original_word = generate_random_word(args.length, args.lower, args.upper, args.digits)
        md5_hash = hashlib.md5(original_word.encode('utf-8')).hexdigest()

        print(f"\nAttempt {i + 1}/{args.trials}:")
        print(f"  Generating word: \"{original_word}\" (MD5: {md5_hash})")

        start_time = time.perf_counter()
        try:
            # print(f"  DEBUG: Connecting to {args.server_url}...")
            response = await crack_hash_via_websocket(args.server_url, md5_hash)
            end_time = time.perf_counter()
            elapsed_time = end_time - start_time

            # print(f"  DEBUG: Received response: {response}")

            if "password" in response:
                cracked_password = response["password"]
                if cracked_password == original_word:
                    successful_cracks += 1
                    total_time_for_successful_cracks += elapsed_time
                    print(f"  SUCCESS: Server cracked \"{original_word}\" in {elapsed_time:.4f} seconds.")
                elif cracked_password == "Non trovato":
                    print(f"  INFO: Server reported \"Non trovato\" for \"{original_word}\". (Time: {elapsed_time:.4f}s)")
                else: 
                    print(f"  MISMATCH: Server returned \"{cracked_password}\", but original was \"{original_word}\". (Time: {elapsed_time:.4f}s)")
            elif "error" in response:
                print(f"  SERVER ERROR: {response['error']}. (Time: {elapsed_time:.4f}s)")
            else:
                print(f"  UNEXPECTED RESPONSE from server: {response}. (Time: {elapsed_time:.4f}s)")

        except websockets.exceptions.ConnectionClosedError as e:
            print(f"  ERROR: Connection to server closed unexpectedly: {e}")
        except websockets.exceptions.InvalidURI:
            print(f"  ERROR: Invalid server URI: {args.server_url}")
            print("Stopping trials.")
            break
        except ConnectionRefusedError:
            print(f"  ERROR: Connection refused by server at {args.server_url}. Ensure the server is running.")
            print("Stopping trials.")
            break 
        except OSError as e: 
            print(f"  ERROR: Network or OS error connecting to {args.server_url}: {e}")
            print("Stopping trials.")
            break
        except json.JSONDecodeError as e:
            print(f"  ERROR: Could not decode JSON response from server: {e}")
        except Exception as e:
            print(f"  ERROR: An unexpected error occurred: {type(e).__name__} - {e}")
            # For deeper debugging, you might uncomment the following:
            # import traceback
            # traceback.print_exc()
    
    print("-" * 40)
    print("\nTest Run Summary:")
    print(f"  Total trials attempted: {completed_trials}")
    print(f"  Successfully cracked and verified words: {successful_cracks}")

    if successful_cracks > 0:
        average_time = total_time_for_successful_cracks / successful_cracks
        print(f"  Average time for successful cracks: {average_time:.4f} seconds.")
    elif completed_trials > 0 :
        print("  No words were successfully cracked and verified by the server.")
    else:
        print("  No trials were completed.")
    
    print("\nReminder: This script requires the 'websockets' library.")
    print("You can install it using: pip install websockets")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nTest interrupted by user.")
    except Exception as e:
        print(f"\nAn unhandled error occurred in main execution: {e}")