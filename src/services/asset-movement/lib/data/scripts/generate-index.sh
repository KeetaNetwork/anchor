#! /usr/bin/env bash

set -eo pipefail

# Directory containing address schema sources
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

addresses_dir="${script_dir}/../addresses"
output_file="${addresses_dir}/index.generated.ts"

if [ ! -d "${addresses_dir}" ]; then
	echo "Directory not found: ${addresses_dir}" >&2
	exit 1
fi

source_files=()
while IFS= read -r path; do
	source_files+=("${path}")
done < <(find "${addresses_dir}" -maxdepth 1 -type f -name '*.ts' ! -name '*.generated.ts' -print | sort)

printf '%s\n' '// Auto-generated snippet derived from generate-index.sh'
for path in "${source_files[@]}"; do
	file_name="$(basename "${path}" .ts)"
	var_name="${file_name//-/_}"
	printf 'import %s from "./%s.js";%s' "${var_name}" "${file_name}" $'\n'
done

printf '%s\n' 'export const definitions: {'
for path in "${source_files[@]}"; do
	file_name="$(basename "${path}" .ts)"
	var_name="${file_name//-/_}"
	printf "\t'%s': typeof %s;%s" "${file_name}" "${var_name}" $'\n'
done
printf '%s\n' '} = {'
for i in "${!source_files[@]}"; do
	file_name="$(basename "${source_files[$i]}" .ts)"
	var_name="${file_name//-/_}"
	tail_char=','
	if [ "$i" -eq $((${#source_files[@]} - 1)) ]; then
		tail_char=''
	fi
	printf "\t'%s': %s%s%s" "${file_name}" "${var_name}" "${tail_char}" $'\n'
done
printf '%s\n' '};'

