// This file contains the logic for the persistent window. It handles user interactions and updates the UI as needed.

document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('myButton');
    const output = document.getElementById('output');

    if (button) {
        button.addEventListener('click', () => {
            output.textContent = 'Button clicked!';
        });
    }
});